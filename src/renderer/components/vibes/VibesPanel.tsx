import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Settings, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import DiscoBallIcon from '../icons/DiscoBallIcon';
import type { Theme } from '../../types';
import { useSettings, useVibesData } from '../../hooks';
import { VibesDashboard } from './VibesDashboard';
import { VibesAnnotationLog } from './VibesAnnotationLog';
import { VibesModelAttribution } from './VibesModelAttribution';
import { VibesBlameView } from './VibesBlameView';
import { VibeCoverageView } from './VibeCoverageView';
import { VibesReportView } from './VibesReportView';

// ============================================================================
// Sub-tab type
// ============================================================================

type VibesSubTab = 'overview' | 'log' | 'models' | 'blame' | 'coverage' | 'reports';

const SUB_TABS: { key: VibesSubTab; label: string }[] = [
	{ key: 'overview', label: 'Overview' },
	{ key: 'log', label: 'Log' },
	{ key: 'models', label: 'Models' },
	{ key: 'blame', label: 'Blame' },
	{ key: 'coverage', label: 'Coverage' },
	{ key: 'reports', label: 'Reports' },
];

// ============================================================================
// Props
// ============================================================================

interface VibesPanelProps {
	theme: Theme;
	projectPath: string | undefined;
	/** Optional file path to pre-select in the blame view (e.g. from file explorer context menu). */
	initialBlameFilePath?: string;
	/** Callback to clear the initialBlameFilePath after it has been consumed. */
	onBlameFileConsumed?: () => void;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Main VIBES panel container component.
 * Rendered in the Right Panel when the VIBES tab is active.
 *
 * Features:
 * - Sub-navigation bar with Overview / Log / Models / Blame / Coverage / Reports tabs
 * - Scrollable tab bar to accommodate 6 sub-tabs
 * - Disabled state message when VIBES is off, with button to open Settings
 * - Passes projectPath and vibesData to child components
 * - Accepts initialBlameFilePath to auto-navigate to blame view with a pre-selected file
 */
export const VibesPanel: React.FC<VibesPanelProps> = ({
	theme,
	projectPath,
	initialBlameFilePath,
	onBlameFileConsumed,
}) => {
	const [activeSubTab, setActiveSubTab] = useState<VibesSubTab>('overview');
	const [blameFilePath, setBlameFilePath] = useState<string | undefined>(undefined);
	const [binaryAvailable, setBinaryAvailable] = useState<boolean | null>(null);
	const [binaryVersion, setBinaryVersion] = useState<string | null>(null);
	const [showInstallGuide, setShowInstallGuide] = useState(false);
	const { vibesEnabled, vibesAssuranceLevel, vibesAutoInit } = useSettings();
	const vibesData = useVibesData(projectPath, vibesEnabled);

	// Check vibecheck binary availability on mount
	useEffect(() => {
		if (!vibesEnabled) return;
		let cancelled = false;
		(async () => {
			try {
				const result = await window.maestro.vibes.findBinary();
				if (!cancelled) {
					setBinaryAvailable(!!result.path);
					setBinaryVersion(result.version ?? null);
				}
			} catch {
				if (!cancelled) {
					setBinaryAvailable(false);
				}
			}
		})();
		return () => { cancelled = true; };
	}, [vibesEnabled]);

	const handleCheckBinary = useCallback(async () => {
		try {
			const result = await window.maestro.vibes.findBinary();
			setBinaryAvailable(!!result.path);
			setBinaryVersion(result.version ?? null);
			if (result.path) setShowInstallGuide(false);
		} catch {
			setBinaryAvailable(false);
		}
	}, []);

	// When an initialBlameFilePath is provided, switch to blame tab and set the file path
	useEffect(() => {
		if (initialBlameFilePath) {
			setBlameFilePath(initialBlameFilePath);
			setActiveSubTab('blame');
			onBlameFileConsumed?.();
		}
	}, [initialBlameFilePath, onBlameFileConsumed]);

	const handleOpenSettings = useCallback(() => {
		// Dispatch tour:action event to open settings (same event bus as other UI actions)
		window.dispatchEvent(
			new CustomEvent('tour:action', {
				detail: { type: 'openSettings' },
			}),
		);
	}, []);

	// Last-refreshed timestamp tracking
	const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
	const [relativeTime, setRelativeTime] = useState<string>('');

	// Update lastRefreshed when data finishes loading
	const prevLoadingRef = useRef(vibesData.isLoading);
	useEffect(() => {
		if (prevLoadingRef.current && !vibesData.isLoading) {
			setLastRefreshed(Date.now());
		}
		prevLoadingRef.current = vibesData.isLoading;
	}, [vibesData.isLoading]);

	// Update relative time display every second
	useEffect(() => {
		if (!lastRefreshed) return;
		const update = () => {
			const delta = Math.floor((Date.now() - lastRefreshed) / 1000);
			if (delta < 5) setRelativeTime('just now');
			else if (delta < 60) setRelativeTime(`${delta}s ago`);
			else if (delta < 3600) setRelativeTime(`${Math.floor(delta / 60)}m ago`);
			else setRelativeTime(`${Math.floor(delta / 3600)}h ago`);
		};
		update();
		const id = setInterval(update, 1000);
		return () => clearInterval(id);
	}, [lastRefreshed]);

	const handleRefresh = useCallback(() => {
		vibesData.refresh();
	}, [vibesData]);

	// Keyboard shortcut: Ctrl+Shift+R (or Cmd+Shift+R on macOS)
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key === 'R') {
				e.preventDefault();
				vibesData.refresh();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [vibesData]);

	// ========================================================================
	// Disabled state — VIBES is off in settings
	// ========================================================================

	if (!vibesEnabled) {
		return (
			<div className="h-full flex flex-col items-center justify-center gap-3 text-center px-4">
				<DiscoBallIcon className="w-8 h-8 opacity-40" style={{ color: theme.colors.textDim }} />
				<span
					className="text-sm font-medium"
					style={{ color: theme.colors.textMain }}
				>
					VIBES is disabled
				</span>
				<span
					className="text-xs max-w-xs"
					style={{ color: theme.colors.textDim }}
				>
					Enable VIBES in Settings to start tracking AI attribution metadata for your project.
				</span>
				<button
					onClick={handleOpenSettings}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80 mt-1"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					<Settings className="w-3.5 h-3.5" />
					Open Settings
				</button>
			</div>
		);
	}

	// ========================================================================
	// Active state — sub-tab navigation + content
	// ========================================================================

	return (
		<div className="h-full flex flex-col">
			{/* Sub-tab navigation bar — scrollable for 6 tabs + refresh button */}
			<div
				className="flex overflow-x-auto border-b shrink-0 scrollbar-thin"
				style={{ borderColor: theme.colors.border }}
			>
				{SUB_TABS.map((tab) => (
					<button
						key={tab.key}
						onClick={() => setActiveSubTab(tab.key)}
						className="shrink-0 px-3 py-2 text-[11px] font-semibold border-b-2 transition-colors whitespace-nowrap"
						style={{
							borderColor: activeSubTab === tab.key ? theme.colors.accent : 'transparent',
							color: activeSubTab === tab.key ? theme.colors.textMain : theme.colors.textDim,
						}}
					>
						{tab.label}
					</button>
				))}
				<div className="flex-1" />
				{/* Binary version indicator */}
				{binaryAvailable === true && binaryVersion && (
					<span
						className="shrink-0 flex items-center gap-1 px-2 text-[10px]"
						style={{ color: theme.colors.success }}
						data-testid="binary-version-badge"
					>
						<CheckCircle2 className="w-3 h-3" />
						v{binaryVersion}
					</span>
				)}
				{relativeTime && (
					<span
						className="shrink-0 text-[10px] px-1"
						style={{ color: theme.colors.textDim }}
						data-testid="last-updated-label"
					>
						{relativeTime}
					</span>
				)}
				<button
					onClick={handleRefresh}
					title="Refresh VIBES data (Ctrl+Shift+R)"
					className="shrink-0 px-2 py-2 transition-opacity hover:opacity-80"
					style={{ color: theme.colors.textDim }}
					data-testid="vibes-refresh-button"
				>
					<RefreshCw
						className={`w-3.5 h-3.5${vibesData.isLoading ? ' animate-spin' : ''}`}
					/>
				</button>
			</div>

			{/* Binary not-found banner */}
			{binaryAvailable === false && (
				<div
					className="flex flex-col gap-1.5 px-3 py-2 border-b text-xs"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: 'rgba(234, 179, 8, 0.06)',
					}}
					data-testid="binary-not-found-banner"
				>
					<div className="flex items-center gap-2">
						<AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: '#eab308' }} />
						<span className="font-medium" style={{ color: '#eab308' }}>
							vibecheck not found
						</span>
						<span style={{ color: theme.colors.textDim }}>
							— Blame, Coverage, Reports, and Build require vibecheck.
						</span>
						<div className="flex-1" />
						<button
							onClick={() => setShowInstallGuide((prev) => !prev)}
							className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium hover:opacity-80"
							style={{ backgroundColor: theme.colors.accentDim, color: theme.colors.accent }}
							data-testid="install-guide-btn"
						>
							{showInstallGuide ? 'Hide Guide' : 'Install Guide'}
						</button>
						<button
							onClick={handleOpenSettings}
							className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium hover:opacity-80"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							Set Custom Path
						</button>
					</div>
					{showInstallGuide && (
						<div
							className="flex flex-col gap-2 p-2.5 rounded mt-1"
							style={{ backgroundColor: theme.colors.bgActivity }}
							data-testid="install-guide-panel"
						>
							<span className="text-[10px] font-semibold" style={{ color: theme.colors.textMain }}>
								Install vibecheck
							</span>
							<div className="flex flex-col gap-1.5 text-[10px]" style={{ color: theme.colors.textDim }}>
								<div className="flex flex-col gap-1">
									<span className="font-medium">From source (requires Rust):</span>
									<code className="font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
										git clone https://github.com/openasocket/VibeCheck.git && cd VibeCheck && cargo install --path .
									</code>
								</div>
								<div className="flex flex-col gap-1">
									<span className="font-medium">Or build manually:</span>
									<code className="font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
										git clone https://github.com/openasocket/VibeCheck.git && cd VibeCheck && cargo build --release
									</code>
									<span>Then copy <code className="font-mono">target/release/vibecheck</code> to a directory in your PATH (e.g. <code className="font-mono">/usr/local/bin/</code>)</span>
								</div>
								<a
									href="https://github.com/openasocket/VibeCheck"
									target="_blank"
									rel="noopener noreferrer"
									className="underline"
									style={{ color: theme.colors.accent }}
								>
									View README on GitHub
								</a>
							</div>
							<button
								onClick={handleCheckBinary}
								className="self-start px-2.5 py-1 rounded text-[10px] font-medium hover:opacity-80 mt-1"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
								data-testid="check-again-btn"
							>
								Check Again
							</button>
						</div>
					)}
				</div>
			)}

			{/* Sub-tab content */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
				{activeSubTab === 'overview' && (
					<VibesDashboard
						theme={theme}
						projectPath={projectPath}
						vibesData={vibesData}
						vibesEnabled={vibesEnabled}
						vibesAssuranceLevel={vibesAssuranceLevel}
						vibesAutoInit={vibesAutoInit}
						binaryAvailable={binaryAvailable}
					/>
				)}

				{activeSubTab === 'log' && (
					<VibesAnnotationLog
						theme={theme}
						annotations={vibesData.annotations}
						isLoading={vibesData.isLoading}
						projectPath={projectPath}
					/>
				)}

				{activeSubTab === 'models' && (
					<VibesModelAttribution
						theme={theme}
						models={vibesData.models}
						isLoading={vibesData.isLoading}
					/>
				)}

				{activeSubTab === 'blame' && (
					<VibesBlameView
						theme={theme}
						projectPath={projectPath}
						initialFilePath={blameFilePath}
						binaryAvailable={binaryAvailable}
					/>
				)}

				{activeSubTab === 'coverage' && (
					<VibeCoverageView
						theme={theme}
						projectPath={projectPath}
						binaryAvailable={binaryAvailable}
					/>
				)}

				{activeSubTab === 'reports' && (
					<VibesReportView
						theme={theme}
						projectPath={projectPath}
						binaryAvailable={binaryAvailable}
					/>
				)}
			</div>
		</div>
	);
};
