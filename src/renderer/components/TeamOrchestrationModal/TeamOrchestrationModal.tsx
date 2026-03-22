/**
 * TeamOrchestrationModal
 *
 * Modal shell for Team Orchestration management with tab navigation.
 * Provides Overview, Templates, Configuration, Analytics, and History views.
 *
 * Features:
 * - Five-tab navigation with keyboard support
 * - Cmd+Shift+[ / Cmd+Shift+] to cycle tabs
 * - Arrow key navigation in tab bar
 * - Theme-aware styling
 * - Layer stack integration for proper Escape handling
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Users, Calendar } from 'lucide-react';
import type { Theme } from '../../types';
import type { TeamOrchTimeRange } from '../../../shared/team-orch-stats-types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useTeamOrchStats } from '../../hooks/teamOrch/useTeamOrchStats';
import { OverviewTab } from './OverviewTab';
import { TemplatesTab } from './TemplatesTab';
import { ConfigurationTab } from './ConfigurationTab';
import { AnalyticsTab } from './AnalyticsTab';
import { HistoryTab } from './HistoryTab';

type TabId = 'overview' | 'templates' | 'configuration' | 'analytics' | 'history';

const TABS: { value: TabId; label: string }[] = [
	{ value: 'overview', label: 'Overview' },
	{ value: 'templates', label: 'Templates' },
	{ value: 'configuration', label: 'Configuration' },
	{ value: 'analytics', label: 'Analytics' },
	{ value: 'history', label: 'History' },
];

const TIME_RANGE_OPTIONS: { value: TeamOrchTimeRange; label: string }[] = [
	{ value: 'day', label: 'Today' },
	{ value: 'week', label: 'This Week' },
	{ value: 'month', label: 'This Month' },
	{ value: 'quarter', label: 'This Quarter' },
	{ value: 'year', label: 'This Year' },
	{ value: 'all', label: 'All Time' },
];

interface TeamOrchestrationModalProps {
	theme: Theme;
	onClose: () => void;
	colorBlindMode?: boolean;
}

export function TeamOrchestrationModal({
	theme,
	onClose,
	colorBlindMode = false,
}: TeamOrchestrationModalProps) {
	const [activeTab, setActiveTab] = useState<TabId>('overview');
	const [timeRange, setTimeRange] = useState<TeamOrchTimeRange>('month');
	const containerRef = useRef<HTMLDivElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);

	const stats = useTeamOrchStats(timeRange, true);
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const activeTabRef = useRef(activeTab);
	activeTabRef.current = activeTab;

	// Register with layer stack for proper Escape handling
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.TEAM_ORCHESTRATION_MODAL,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'lenient',
			onEscape: () => onCloseRef.current(),
		});
		return () => unregisterLayer(id);
	}, [registerLayer, unregisterLayer]);

	// Focus container on mount
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	const switchTab = useCallback((tab: TabId) => {
		setActiveTab(tab);
	}, []);

	// Handle Cmd+Shift+[ and Cmd+Shift+] for tab navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();

				const currentIndex = TABS.findIndex((tab) => tab.value === activeTabRef.current);

				if (e.key === '[') {
					const prevIndex = currentIndex > 0 ? currentIndex - 1 : TABS.length - 1;
					switchTab(TABS[prevIndex].value);
				} else {
					const nextIndex = currentIndex < TABS.length - 1 ? currentIndex + 1 : 0;
					switchTab(TABS[nextIndex].value);
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [switchTab]);

	// Handle arrow key navigation in tab bar
	const handleTabKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const currentIndex = TABS.findIndex((tab) => tab.value === activeTab);

			if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
				event.preventDefault();
				const prevIndex = currentIndex > 0 ? currentIndex - 1 : TABS.length - 1;
				switchTab(TABS[prevIndex].value);
			} else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
				event.preventDefault();
				const nextIndex = currentIndex < TABS.length - 1 ? currentIndex + 1 : 0;
				switchTab(TABS[nextIndex].value);
			}
		},
		[activeTab, switchTab]
	);

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
			onClick={onClose}
		>
			<button
				type="button"
				className="absolute inset-0"
				tabIndex={-1}
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				aria-label="Close team orchestration"
			/>
			<div
				ref={containerRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Team Orchestration"
				className="relative z-10 rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none max-w-6xl w-[95vw] max-h-[90vh]"
				onClick={(e) => e.stopPropagation()}
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<Users className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Team Orchestration
						</h2>
					</div>

					<div className="flex items-center gap-3">
						{/* Time Range Selector — shared between Overview and Analytics */}
						{(activeTab === 'overview' || activeTab === 'analytics') && (
							<div className="relative flex items-center">
								<Calendar
									className="absolute left-2 w-3.5 h-3.5 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								/>
								<select
									value={timeRange}
									onChange={(e) => setTimeRange(e.target.value as TeamOrchTimeRange)}
									className="pl-7 pr-6 py-1.5 rounded text-sm border cursor-pointer outline-none appearance-none"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									aria-label="Select time range"
								>
									{TIME_RANGE_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
								<div
									className="absolute right-1.5 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								>
									<svg
										width="10"
										height="6"
										viewBox="0 0 10 6"
										fill="currentColor"
										aria-hidden="true"
									>
										<path d="M0 0l5 6 5-6z" />
									</svg>
								</div>
							</div>
						)}

						<button
							onClick={onClose}
							className="p-1.5 rounded hover:bg-opacity-10 transition-colors"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							aria-label="Close (Esc)"
						>
							<X className="w-4 h-4" aria-hidden="true" />
						</button>
					</div>
				</div>

				{/* Tab Bar */}
				<div
					ref={tabsRef}
					className="px-6 py-2 border-b flex items-center gap-1 flex-shrink-0 outline-none"
					style={{ borderColor: theme.colors.border }}
					role="tablist"
					aria-label="Team orchestration tabs"
					tabIndex={0}
					onKeyDown={handleTabKeyDown}
				>
					{TABS.map((tab) => (
						<button
							key={tab.value}
							onClick={() => switchTab(tab.value)}
							className="px-4 py-2 rounded-lg text-sm font-medium transition-colors outline-none"
							style={{
								backgroundColor:
									activeTab === tab.value ? `${theme.colors.accent}20` : 'transparent',
								color: activeTab === tab.value ? theme.colors.accent : theme.colors.textDim,
							}}
							onMouseEnter={(e) => {
								if (activeTab !== tab.value) {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
								}
							}}
							onMouseLeave={(e) => {
								if (activeTab !== tab.value) {
									e.currentTarget.style.backgroundColor = 'transparent';
								}
							}}
							role="tab"
							aria-selected={activeTab === tab.value}
							aria-controls={`tabpanel-${tab.value}`}
							id={`tab-${tab.value}`}
							tabIndex={-1}
						>
							{tab.label}
						</button>
					))}
				</div>

				{/* Tab Content */}
				<div
					className="flex-1 overflow-y-auto scrollbar-thin p-6"
					style={{ backgroundColor: theme.colors.bgMain }}
					role="tabpanel"
					aria-labelledby={`tab-${activeTab}`}
					id={`tabpanel-${activeTab}`}
				>
					{activeTab === 'overview' ? (
						<OverviewTab
							theme={theme}
							data={stats.data}
							loading={stats.loading}
							colorBlindMode={colorBlindMode}
						/>
					) : activeTab === 'templates' ? (
						<TemplatesTab theme={theme} data={stats.data} />
					) : activeTab === 'configuration' ? (
						<ConfigurationTab theme={theme} />
					) : activeTab === 'analytics' ? (
						<AnalyticsTab
							theme={theme}
							data={stats.data}
							loading={stats.loading}
							timeRange={timeRange}
							onTimeRangeChange={setTimeRange}
							colorBlindMode={colorBlindMode}
						/>
					) : activeTab === 'history' ? (
						<HistoryTab theme={theme} />
					) : (
						<div
							className="flex items-center justify-center h-full min-h-[200px]"
							style={{ color: theme.colors.textDim }}
						>
							<p className="text-sm">
								{TABS.find((t) => t.value === activeTab)?.label} — coming soon
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
