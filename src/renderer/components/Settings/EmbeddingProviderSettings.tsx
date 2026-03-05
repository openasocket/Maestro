/**
 * EmbeddingProviderSettings - Full embedding provider configuration component.
 *
 * Renders provider cards with status indicators, provider-specific settings,
 * and handles provider switching via IPC.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
	Loader2,
	Cpu,
	Cloud,
	Server,
	AlertTriangle,
	CheckCircle2,
	Trash2,
	RefreshCw,
	Download,
	Eye,
	EyeOff,
	RotateCcw,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	EmbeddingProviderId,
	EmbeddingProviderConfig,
} from '../../../shared/memory-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../shared/memory-types';
import type { EmbeddingProviderStatus } from '../../../main/grpo/embedding-types';
import { notifyToast } from '../../stores/notificationStore';

interface EmbeddingProviderSettingsProps {
	theme: Theme;
	config: MemoryConfig;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
}

interface ProviderCardInfo {
	id: EmbeddingProviderId;
	name: string;
	shortName: string;
	isLocal: boolean;
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

const PROVIDERS: ProviderCardInfo[] = [
	{
		id: 'transformers-js',
		name: 'Transformers.js',
		shortName: 'Transformers.js',
		isLocal: true,
		icon: Cpu,
	},
	{ id: 'ollama', name: 'Ollama (Local)', shortName: 'Ollama', isLocal: true, icon: Server },
	{ id: 'openai', name: 'OpenAI (Cloud)', shortName: 'OpenAI', isLocal: false, icon: Cloud },
	{ id: 'xenova-onnx', name: 'Xenova (ONNX)', shortName: 'Xenova', isLocal: true, icon: Cpu },
];

type StatusLevel = 'ready' | 'available' | 'unavailable' | 'error';

function getStatusLevel(
	providerId: EmbeddingProviderId,
	activeId: EmbeddingProviderId | null,
	status: EmbeddingProviderStatus | undefined,
	available: EmbeddingProviderId[],
	hasKey: boolean
): StatusLevel {
	if (status?.error) return 'error';
	if (status?.ready && providerId === activeId) return 'ready';
	if (providerId === 'openai' && !hasKey) return 'unavailable';
	if (available.includes(providerId)) return 'available';
	return 'unavailable';
}

function getStatusLabel(
	level: StatusLevel,
	providerId: EmbeddingProviderId,
	hasKey: boolean
): string {
	switch (level) {
		case 'ready':
			return 'Ready';
		case 'available':
			return 'Available';
		case 'error':
			return 'Error';
		case 'unavailable':
			if (providerId === 'openai' && !hasKey) return 'No Key';
			return 'Not Available';
	}
}

function getStatusColor(level: StatusLevel, theme: Theme): string {
	switch (level) {
		case 'ready':
			return theme.colors.success;
		case 'available':
			return theme.colors.warning;
		case 'error':
			return theme.colors.error;
		case 'unavailable':
			return theme.colors.textDim;
	}
}

const OPENAI_MODELS = [
	{ value: 'text-embedding-3-small', label: 'text-embedding-3-small', cost: 0.02 },
	{ value: 'text-embedding-3-large', label: 'text-embedding-3-large', cost: 0.13 },
	{ value: 'text-embedding-ada-002', label: 'text-embedding-ada-002', cost: 0.1 },
];

export function EmbeddingProviderSettings({
	theme,
	config,
	onUpdateConfig,
}: EmbeddingProviderSettingsProps): React.ReactElement {
	const embeddingConfig = config.embeddingProvider ?? DEFAULT_EMBEDDING_CONFIG;
	const activeProviderId = embeddingConfig.enabled ? embeddingConfig.providerId : null;

	// Provider status from IPC
	const [statuses, setStatuses] = useState<Record<string, EmbeddingProviderStatus>>({});
	const [available, setAvailable] = useState<EmbeddingProviderId[]>([]);
	const [hasOpenAIKey, setHasOpenAIKey] = useState(false);
	const [switching, setSwitching] = useState(false);

	// Ollama state
	const [ollamaModels, setOllamaModels] = useState<string[]>([]);
	const [ollamaConnected, setOllamaConnected] = useState(false);
	const [ollamaChecking, setOllamaChecking] = useState(false);
	const [ollamaPulling, setOllamaPulling] = useState(false);

	// OpenAI key input
	const [keyInput, setKeyInput] = useState('');
	const [showKey, setShowKey] = useState(false);
	const [settingKey, setSettingKey] = useState(false);

	// Re-embed state
	const [reEmbedding, setReEmbedding] = useState(false);
	const [reEmbedResult, setReEmbedResult] = useState<{
		total: number;
		succeeded: number;
		failed: number;
		durationMs: number;
	} | null>(null);

	// Progress
	const [progress, setProgress] = useState<{
		progress: number;
		status: 'downloading' | 'loading' | 'ready' | 'error';
		message?: string;
	} | null>(null);

	const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchStatus = useCallback(async () => {
		try {
			const [statusRes, availRes, keyRes] = await Promise.all([
				window.maestro.embedding.getStatus(),
				window.maestro.embedding.detectAvailable(),
				window.maestro.embedding.hasOpenAIKey(),
			]);
			if (statusRes.success) setStatuses(statusRes.data.statuses);
			if (availRes.success) setAvailable(availRes.data.available);
			if (keyRes.success) setHasOpenAIKey(keyRes.data);
		} catch {
			// Non-critical
		}
	}, []);

	// Fetch status on mount and periodically
	useEffect(() => {
		fetchStatus();
		refreshTimerRef.current = setInterval(fetchStatus, 10000);
		return () => {
			if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
		};
	}, [fetchStatus]);

	// Refresh on window focus
	useEffect(() => {
		const handleFocus = () => fetchStatus();
		window.addEventListener('focus', handleFocus);
		return () => window.removeEventListener('focus', handleFocus);
	}, [fetchStatus]);

	// Subscribe to progress events
	useEffect(() => {
		const unsub = window.maestro.embedding.onProgress((event) => {
			setProgress({
				progress: event.progress,
				status: event.status,
				message: event.message,
			});
			if (event.status === 'downloading' || event.status === 'loading') {
				setSwitching(true);
			}
			if (event.status === 'ready') {
				setSwitching(false);
				fetchStatus();
				notifyToast({
					type: 'success',
					title: 'Embedding Provider Ready',
					message: `${event.modelId} loaded successfully`,
					duration: 3000,
				});
				setTimeout(() => setProgress(null), 3000);
			}
			if (event.status === 'error') {
				setSwitching(false);
				notifyToast({
					type: 'error',
					title: 'Embedding Provider Error',
					message: event.message ?? 'Failed to initialize provider',
					duration: 5000,
				});
			}
		});
		return unsub;
	}, [fetchStatus]);

	const handleReEmbedAll = useCallback(async () => {
		if (reEmbedding) return;
		setReEmbedding(true);
		setReEmbedResult(null);
		try {
			const res = await window.maestro.memory.reEmbedAll();
			if (res.success) {
				setReEmbedResult(res.data);
				notifyToast({
					type: 'success',
					title: 'Re-embedding Complete',
					message: `${res.data.succeeded}/${res.data.total} memories re-embedded in ${(res.data.durationMs / 1000).toFixed(1)}s`,
					duration: 5000,
				});
			} else {
				notifyToast({
					type: 'error',
					title: 'Re-embedding Failed',
					message: res.error ?? 'Unknown error',
					duration: 5000,
				});
			}
		} catch (err) {
			notifyToast({
				type: 'error',
				title: 'Re-embedding Failed',
				message: err instanceof Error ? err.message : 'Unknown error',
				duration: 5000,
			});
		} finally {
			setReEmbedding(false);
		}
	}, [reEmbedding]);

	const handleSelectProvider = useCallback(
		async (providerId: EmbeddingProviderId) => {
			if (switching) return;

			const isProviderSwitch = activeProviderId && activeProviderId !== providerId;

			if (isProviderSwitch) {
				const confirmed = window.confirm(
					'Switching embedding providers requires re-computing all embeddings. ' +
						'This may take a few minutes for large memory stores. Proceed?'
				);
				if (!confirmed) return;
			}

			setSwitching(true);
			try {
				const newEmbeddingConfig: EmbeddingProviderConfig = {
					...embeddingConfig,
					providerId,
					enabled: true,
				};
				const res = await window.maestro.embedding.switchProvider(providerId, newEmbeddingConfig);
				if (res.success) {
					onUpdateConfig({ embeddingProvider: newEmbeddingConfig });
					fetchStatus();

					// Trigger re-embedding after provider switch
					if (isProviderSwitch) {
						// Small delay to let the provider fully initialize
						setTimeout(() => {
							handleReEmbedAll();
						}, 500);
					}
				} else {
					notifyToast({
						type: 'error',
						title: 'Switch Failed',
						message: res.error ?? 'Failed to switch embedding provider',
						duration: 5000,
					});
					setSwitching(false);
				}
			} catch (err) {
				notifyToast({
					type: 'error',
					title: 'Switch Failed',
					message: err instanceof Error ? err.message : 'Unknown error',
					duration: 5000,
				});
				setSwitching(false);
			}
		},
		[switching, activeProviderId, embeddingConfig, onUpdateConfig, fetchStatus, handleReEmbedAll]
	);

	// Ollama helpers
	const checkOllamaConnection = useCallback(async () => {
		const baseUrl = embeddingConfig.ollama?.baseUrl ?? 'http://localhost:11434';
		setOllamaChecking(true);
		try {
			const [connRes, modelsRes] = await Promise.all([
				window.maestro.embedding.checkOllamaConnection(baseUrl),
				window.maestro.embedding.getOllamaModels(baseUrl),
			]);
			if (connRes.success) setOllamaConnected(connRes.data.connected);
			if (modelsRes.success) setOllamaModels(modelsRes.data.models);
		} catch {
			setOllamaConnected(false);
		} finally {
			setOllamaChecking(false);
		}
	}, [embeddingConfig.ollama?.baseUrl]);

	const handlePullOllamaModel = useCallback(async () => {
		const model = embeddingConfig.ollama?.model ?? 'nomic-embed-text';
		const baseUrl = embeddingConfig.ollama?.baseUrl ?? 'http://localhost:11434';
		setOllamaPulling(true);
		try {
			await window.maestro.embedding.pullOllamaModel(model, baseUrl);
			notifyToast({
				type: 'success',
				title: 'Model Pull Started',
				message: `Pulling ${model}...`,
				duration: 3000,
			});
		} catch {
			notifyToast({
				type: 'error',
				title: 'Pull Failed',
				message: `Failed to pull ${model}`,
				duration: 5000,
			});
		} finally {
			setOllamaPulling(false);
		}
	}, [embeddingConfig.ollama]);

	// OpenAI key helpers
	const handleSetKey = useCallback(async () => {
		if (!keyInput.trim()) return;
		setSettingKey(true);
		try {
			const res = await window.maestro.embedding.setOpenAIKey(keyInput.trim());
			if (res.success) {
				setHasOpenAIKey(true);
				setKeyInput('');
				notifyToast({
					type: 'success',
					title: 'API Key Set',
					message: 'OpenAI API key saved',
					duration: 3000,
				});
			}
		} catch {
			notifyToast({
				type: 'error',
				title: 'Failed',
				message: 'Could not save API key',
				duration: 5000,
			});
		} finally {
			setSettingKey(false);
		}
	}, [keyInput]);

	const handleClearKey = useCallback(async () => {
		try {
			await window.maestro.embedding.clearOpenAIKey();
			setHasOpenAIKey(false);
			notifyToast({
				type: 'info',
				title: 'Key Cleared',
				message: 'OpenAI API key removed',
				duration: 3000,
			});
		} catch {
			// ignore
		}
	}, []);

	// Active provider label
	const activeStatus = activeProviderId ? statuses[activeProviderId] : null;
	const activeInfo = PROVIDERS.find((p) => p.id === activeProviderId);

	return (
		<div className="space-y-3">
			{/* Header with status */}
			<div className="flex items-center justify-between">
				<div>
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Embedding Provider
					</div>
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						{activeProviderId && activeStatus?.ready ? (
							<>
								<span
									className="inline-block w-2 h-2 rounded-full mr-1"
									style={{ backgroundColor: theme.colors.success }}
								/>
								Ready ({activeInfo?.shortName} / {activeStatus.modelName})
							</>
						) : activeProviderId ? (
							<>
								<span
									className="inline-block w-2 h-2 rounded-full mr-1"
									style={{ backgroundColor: theme.colors.warning }}
								/>
								Initializing...
							</>
						) : (
							'No provider active'
						)}
					</div>
				</div>
			</div>

			{/* Provider Cards */}
			<div className="grid grid-cols-4 gap-2">
				{PROVIDERS.map((provider) => {
					const status = statuses[provider.id];
					const level = getStatusLevel(
						provider.id,
						activeProviderId,
						status,
						available,
						hasOpenAIKey
					);
					const isActive = provider.id === activeProviderId;
					const Icon = provider.icon;
					const statusColor = getStatusColor(level, theme);

					return (
						<button
							key={provider.id}
							className="flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center transition-colors"
							style={{
								borderColor: isActive ? theme.colors.accent : theme.colors.border,
								backgroundColor: isActive ? `${theme.colors.accent}10` : 'transparent',
								opacity: switching ? 0.5 : 1,
								cursor: switching ? 'not-allowed' : 'pointer',
							}}
							onClick={() => handleSelectProvider(provider.id)}
							disabled={switching}
						>
							<Icon
								className="w-4 h-4"
								style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
							/>
							<div
								className="text-[10px] font-medium leading-tight"
								style={{ color: theme.colors.textMain }}
							>
								{provider.shortName}
							</div>
							<div
								className="text-[9px] px-1.5 py-0.5 rounded-full"
								style={{
									backgroundColor: provider.isLocal
										? `${theme.colors.accent}15`
										: `${theme.colors.warning}15`,
									color: provider.isLocal ? theme.colors.accent : theme.colors.warning,
								}}
							>
								{provider.isLocal ? 'Local' : 'Cloud'}
							</div>
							<div className="flex items-center gap-1 text-[10px]" style={{ color: statusColor }}>
								<span
									className="inline-block w-1.5 h-1.5 rounded-full"
									style={{ backgroundColor: statusColor }}
								/>
								{getStatusLabel(level, provider.id, hasOpenAIKey)}
							</div>
						</button>
					);
				})}
			</div>

			{/* Progress Bar */}
			{progress && progress.status !== 'ready' && (
				<div
					className="flex items-center gap-3 p-3 rounded-lg text-xs"
					style={{
						backgroundColor:
							progress.status === 'error' ? `${theme.colors.error}15` : `${theme.colors.accent}10`,
						color: progress.status === 'error' ? theme.colors.error : theme.colors.textMain,
						borderLeft: `3px solid ${progress.status === 'error' ? theme.colors.error : theme.colors.accent}`,
					}}
				>
					{progress.status === 'downloading' && (
						<Download className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
					)}
					{progress.status === 'loading' && (
						<Loader2
							className="w-3.5 h-3.5 shrink-0 animate-spin"
							style={{ color: theme.colors.accent }}
						/>
					)}
					{progress.status === 'error' && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
					<div className="flex-1 min-w-0">
						<div>
							{progress.status === 'downloading'
								? `Downloading model... ${Math.round(progress.progress * 100)}%`
								: progress.status === 'loading'
									? 'Loading model...'
									: (progress.message ?? 'Error')}
						</div>
						{progress.status === 'downloading' && (
							<div
								className="mt-1.5 h-1.5 rounded-full overflow-hidden"
								style={{ backgroundColor: `${theme.colors.accent}20` }}
							>
								<div
									className="h-full rounded-full transition-all"
									style={{
										width: `${Math.round(progress.progress * 100)}%`,
										backgroundColor: theme.colors.accent,
									}}
								/>
							</div>
						)}
					</div>
				</div>
			)}

			{progress?.status === 'ready' && (
				<div
					className="flex items-center gap-2 p-3 rounded-lg text-xs"
					style={{ backgroundColor: `${theme.colors.success}15`, color: theme.colors.success }}
				>
					<CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
					Model ready
				</div>
			)}

			{/* Provider-Specific Settings */}
			{activeProviderId && (
				<div
					className="rounded-lg border p-3 space-y-3"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Provider Settings
					</div>

					{/* Transformers.js / Xenova ONNX */}
					{(activeProviderId === 'transformers-js' || activeProviderId === 'xenova-onnx') && (
						<TransformersSettings
							theme={theme}
							config={embeddingConfig}
							providerId={activeProviderId}
							onUpdateConfig={(updates: Partial<EmbeddingProviderConfig>) =>
								onUpdateConfig({ embeddingProvider: { ...embeddingConfig, ...updates } })
							}
						/>
					)}

					{/* Ollama */}
					{activeProviderId === 'ollama' && (
						<OllamaSettings
							theme={theme}
							config={embeddingConfig}
							models={ollamaModels}
							connected={ollamaConnected}
							checking={ollamaChecking}
							pulling={ollamaPulling}
							onCheckConnection={checkOllamaConnection}
							onPullModel={handlePullOllamaModel}
							onUpdateConfig={(updates: Partial<EmbeddingProviderConfig>) =>
								onUpdateConfig({ embeddingProvider: { ...embeddingConfig, ...updates } })
							}
						/>
					)}

					{/* OpenAI */}
					{activeProviderId === 'openai' && (
						<OpenAISettings
							theme={theme}
							config={embeddingConfig}
							hasKey={hasOpenAIKey}
							keyInput={keyInput}
							showKey={showKey}
							settingKey={settingKey}
							onKeyInputChange={setKeyInput}
							onToggleShowKey={() => setShowKey((v) => !v)}
							onSetKey={handleSetKey}
							onClearKey={handleClearKey}
							onUpdateConfig={(updates: Partial<EmbeddingProviderConfig>) =>
								onUpdateConfig({ embeddingProvider: { ...embeddingConfig, ...updates } })
							}
						/>
					)}

					{/* Re-embed All */}
					<div
						className="flex items-center justify-between pt-2 mt-2"
						style={{ borderTop: `1px solid ${theme.colors.border}` }}
					>
						<div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Re-compute all memory embeddings with the current provider
							</div>
							{reEmbedResult && (
								<div
									className="text-[10px] mt-1"
									style={{
										color: reEmbedResult.failed > 0 ? theme.colors.warning : theme.colors.success,
									}}
								>
									{reEmbedResult.succeeded}/{reEmbedResult.total} succeeded
									{reEmbedResult.failed > 0 && `, ${reEmbedResult.failed} failed`} (
									{(reEmbedResult.durationMs / 1000).toFixed(1)}s)
								</div>
							)}
						</div>
						<button
							className="px-2.5 py-1.5 rounded border text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							onClick={handleReEmbedAll}
							disabled={reEmbedding || switching}
						>
							{reEmbedding ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<RotateCcw className="w-3 h-3" />
							)}
							{reEmbedding ? 'Re-embedding...' : 'Re-embed All'}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

// ─── Transformers.js / Xenova Settings ──────────────────────────────────────

function TransformersSettings({
	theme,
	config,
	providerId,
	onUpdateConfig,
}: {
	theme: Theme;
	config: EmbeddingProviderConfig;
	providerId: 'transformers-js' | 'xenova-onnx';
	onUpdateConfig: (updates: Partial<EmbeddingProviderConfig>) => void;
}) {
	const key = providerId === 'transformers-js' ? 'transformersJs' : 'xenovaOnnx';
	const settings = config[key] ?? { modelId: 'Xenova/gte-small' };

	return (
		<>
			<SettingField label="Model ID" theme={theme}>
				<input
					className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					value={settings.modelId}
					onChange={(e) => onUpdateConfig({ [key]: { ...settings, modelId: e.target.value } })}
				/>
			</SettingField>
			{settings.cacheDir && (
				<SettingField label="Cache Directory" theme={theme}>
					<div
						className="text-xs font-mono truncate"
						style={{ color: theme.colors.textDim }}
						title={settings.cacheDir}
					>
						{settings.cacheDir}
					</div>
				</SettingField>
			)}
		</>
	);
}

// ─── Ollama Settings ────────────────────────────────────────────────────────

function OllamaSettings({
	theme,
	config,
	models,
	connected,
	checking,
	pulling,
	onCheckConnection,
	onPullModel,
	onUpdateConfig,
}: {
	theme: Theme;
	config: EmbeddingProviderConfig;
	models: string[];
	connected: boolean;
	checking: boolean;
	pulling: boolean;
	onCheckConnection: () => void;
	onPullModel: () => void;
	onUpdateConfig: (updates: Partial<EmbeddingProviderConfig>) => void;
}) {
	const ollama = config.ollama ?? { baseUrl: 'http://localhost:11434', model: 'nomic-embed-text' };

	useEffect(() => {
		onCheckConnection();
	}, []);

	return (
		<>
			<SettingField label="Base URL" theme={theme}>
				<input
					className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					value={ollama.baseUrl}
					onChange={(e) => onUpdateConfig({ ollama: { ...ollama, baseUrl: e.target.value } })}
				/>
			</SettingField>

			<SettingField label="Model" theme={theme}>
				{models.length > 0 ? (
					<select
						className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						value={ollama.model}
						onChange={(e) => onUpdateConfig({ ollama: { ...ollama, model: e.target.value } })}
					>
						{models.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
						{!models.includes(ollama.model) && (
							<option value={ollama.model}>{ollama.model} (custom)</option>
						)}
					</select>
				) : (
					<input
						className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						value={ollama.model}
						onChange={(e) => onUpdateConfig({ ollama: { ...ollama, model: e.target.value } })}
						placeholder="nomic-embed-text"
					/>
				)}
			</SettingField>

			<div className="flex items-center gap-2 mt-1">
				<div
					className="flex items-center gap-1.5 text-xs"
					style={{ color: connected ? theme.colors.success : theme.colors.error }}
				>
					<span
						className="inline-block w-2 h-2 rounded-full"
						style={{ backgroundColor: connected ? theme.colors.success : theme.colors.error }}
					/>
					{connected ? 'Connected' : 'Not connected'}
				</div>
				<div className="flex-1" />
				{!models.includes(ollama.model) && connected && (
					<button
						className="px-2 py-1 rounded border text-xs transition-colors disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						onClick={onPullModel}
						disabled={pulling}
					>
						{pulling ? (
							<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
						) : (
							<Download className="w-3 h-3 inline mr-1" />
						)}
						Pull Model
					</button>
				)}
				<button
					className="px-2 py-1 rounded border text-xs transition-colors disabled:opacity-50"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					onClick={onCheckConnection}
					disabled={checking}
				>
					{checking ? (
						<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
					) : (
						<RefreshCw className="w-3 h-3 inline mr-1" />
					)}
					Test Connection
				</button>
			</div>
		</>
	);
}

// ─── OpenAI Settings ────────────────────────────────────────────────────────

function OpenAISettings({
	theme,
	config,
	hasKey,
	keyInput,
	showKey,
	settingKey,
	onKeyInputChange,
	onToggleShowKey,
	onSetKey,
	onClearKey,
	onUpdateConfig,
}: {
	theme: Theme;
	config: EmbeddingProviderConfig;
	hasKey: boolean;
	keyInput: string;
	showKey: boolean;
	settingKey: boolean;
	onKeyInputChange: (v: string) => void;
	onToggleShowKey: () => void;
	onSetKey: () => void;
	onClearKey: () => void;
	onUpdateConfig: (updates: Partial<EmbeddingProviderConfig>) => void;
}) {
	const openai = config.openai ?? {
		apiKey: '',
		model: 'text-embedding-3-small',
		dimensions: 384,
		baseUrl: 'https://api.openai.com/v1',
	};
	const selectedModel = OPENAI_MODELS.find((m) => m.value === openai.model);

	return (
		<>
			{/* API Key */}
			<SettingField label="API Key" theme={theme}>
				{hasKey ? (
					<div className="flex items-center gap-2 flex-1">
						<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
							{'•'.repeat(12)}
						</span>
						<button
							className="px-2 py-1 rounded border text-xs transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.error }}
							onClick={onClearKey}
						>
							<Trash2 className="w-3 h-3 inline mr-1" />
							Clear Key
						</button>
					</div>
				) : (
					<div className="flex items-center gap-1.5 flex-1">
						<div className="relative flex-1">
							<input
								className="w-full p-1.5 pr-7 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								type={showKey ? 'text' : 'password'}
								value={keyInput}
								onChange={(e) => onKeyInputChange(e.target.value)}
								placeholder="sk-..."
								onKeyDown={(e) => {
									if (e.key === 'Enter') onSetKey();
								}}
							/>
							<button
								className="absolute right-1.5 top-1/2 -translate-y-1/2"
								style={{ color: theme.colors.textDim }}
								onClick={onToggleShowKey}
								type="button"
							>
								{showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
							</button>
						</div>
						<button
							className="px-2 py-1.5 rounded border text-xs font-medium transition-colors disabled:opacity-50"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}10`,
							}}
							onClick={onSetKey}
							disabled={settingKey || !keyInput.trim()}
						>
							{settingKey ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Set Key'}
						</button>
					</div>
				)}
			</SettingField>

			{/* Model */}
			<SettingField label="Model" theme={theme}>
				<select
					className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					value={openai.model}
					onChange={(e) => onUpdateConfig({ openai: { ...openai, model: e.target.value } })}
				>
					{OPENAI_MODELS.map((m) => (
						<option key={m.value} value={m.value}>
							{m.label}
						</option>
					))}
				</select>
			</SettingField>

			{/* Dimensions (only for text-embedding-3-*) */}
			{openai.model.startsWith('text-embedding-3') && (
				<SettingField label="Dimensions" theme={theme}>
					<input
						className="w-20 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						type="number"
						value={openai.dimensions}
						min={64}
						max={3072}
						onChange={(e) =>
							onUpdateConfig({
								openai: { ...openai, dimensions: parseInt(e.target.value, 10) || 384 },
							})
						}
					/>
				</SettingField>
			)}

			{/* Base URL */}
			<SettingField label="Base URL" theme={theme}>
				<input
					className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					value={openai.baseUrl}
					onChange={(e) => onUpdateConfig({ openai: { ...openai, baseUrl: e.target.value } })}
				/>
			</SettingField>

			{/* Cost estimate */}
			{selectedModel && (
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Estimated cost: ${selectedModel.cost.toFixed(2)} / 1M tokens
				</div>
			)}
		</>
	);
}

// ─── Shared Setting Field Layout ────────────────────────────────────────────

function SettingField({
	label,
	theme,
	children,
}: {
	label: string;
	theme: Theme;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3">
			<div className="text-xs w-20 shrink-0" style={{ color: theme.colors.textDim }}>
				{label}
			</div>
			{children}
		</div>
	);
}
