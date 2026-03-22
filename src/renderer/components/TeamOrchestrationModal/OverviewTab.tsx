/**
 * OverviewTab
 *
 * Landing tab for the Team Orchestration modal. Displays:
 * - Summary metric cards (via TeamOrchSummaryCards)
 * - Active workflow monitoring with real-time updates
 * - Recent completions list
 *
 * Features:
 * - Real-time execution state via window.maestro.groupChat.onExecutionStateChanged
 * - Initial active workflow fetch from window.maestro.groupChat.list()
 * - Compact WorkflowGraph previews for active workflows
 * - Status-colored badges for completed workflows
 * - Loading skeleton state
 */

import { memo, useState, useEffect, useRef, useCallback } from 'react';
import type { Theme } from '../../types';
import type { TeamOrchAggregation, TeamOrchEvent } from '../../../shared/team-orch-stats-types';
import type {
	WorkflowTopology,
	WorkflowExecutionState,
	GroupChat,
} from '../../../shared/group-chat-types';
import { TeamOrchSummaryCards } from './TeamOrchSummaryCards';
import { TeamOrchSkeleton } from './TeamOrchSkeletons';
import { TeamOrchEmptyState } from './TeamOrchEmptyState';
import { WorkflowGraph } from '../GroupChat/WorkflowGraph';
import {
	formatDuration,
	formatTokenCount,
	topologyDisplayName,
	statusColor,
} from './teamOrchUtils';

interface ActiveWorkflowEntry {
	chatName: string;
	groupChatId: string;
	state: WorkflowExecutionState;
	topology: WorkflowTopology;
}

interface OverviewTabProps {
	theme: Theme;
	data: TeamOrchAggregation | null;
	loading: boolean;
	colorBlindMode?: boolean;
}

export const OverviewTab = memo(function OverviewTab({
	theme,
	data,
	loading,
	colorBlindMode: _colorBlindMode,
}: OverviewTabProps) {
	const [activeWorkflows, setActiveWorkflows] = useState<Map<string, ActiveWorkflowEntry>>(
		new Map()
	);
	const [recentCompletions, setRecentCompletions] = useState<TeamOrchEvent[]>([]);
	const [recentLoading, setRecentLoading] = useState(true);
	const mountedRef = useRef(true);

	// Fetch initial active workflows from groupChat.list()
	useEffect(() => {
		mountedRef.current = true;

		async function fetchActiveWorkflows() {
			try {
				const chats: GroupChat[] = await window.maestro.groupChat.list();
				if (!mountedRef.current) return;

				const active = new Map<string, ActiveWorkflowEntry>();
				for (const chat of chats) {
					if (chat.executionState && chat.executionState.status === 'running' && chat.topology) {
						active.set(chat.id, {
							chatName: chat.name,
							groupChatId: chat.id,
							state: chat.executionState,
							topology: chat.topology,
						});
					}
				}
				setActiveWorkflows(active);
			} catch (err) {
				console.error('Failed to fetch active workflows:', err);
			}
		}

		fetchActiveWorkflows();

		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Subscribe to real-time execution state changes
	useEffect(() => {
		const unsubscribe = window.maestro.groupChat.onExecutionStateChanged(
			(groupChatId: string, state: WorkflowExecutionState) => {
				if (!mountedRef.current) return;

				setActiveWorkflows((prev) => {
					const next = new Map(prev);
					if (state.status === 'running') {
						const existing = next.get(groupChatId);
						if (existing) {
							next.set(groupChatId, { ...existing, state });
						} else {
							// New workflow started — we need to fetch its name and topology
							fetchWorkflowDetails(groupChatId, state, next);
						}
					} else {
						// Terminal status — remove from active
						next.delete(groupChatId);
					}
					return next;
				});
			}
		);

		return () => unsubscribe();
	}, []);

	// Helper to fetch group chat details for a newly-started workflow
	const fetchWorkflowDetails = useCallback(
		async (
			groupChatId: string,
			state: WorkflowExecutionState,
			_currentMap: Map<string, ActiveWorkflowEntry>
		) => {
			try {
				const chat: GroupChat | null = await window.maestro.groupChat.load(groupChatId);
				if (!mountedRef.current) return;
				if (chat && chat.topology) {
					setActiveWorkflows((prev) => {
						const next = new Map(prev);
						next.set(groupChatId, {
							chatName: chat.name,
							groupChatId,
							state,
							topology: chat.topology!,
						});
						return next;
					});
				}
			} catch {
				// Silently fail — workflow may have ended already
			}
		},
		[]
	);

	// Fetch recent completions
	useEffect(() => {
		async function fetchRecentCompletions() {
			try {
				const result = await window.maestro.teamOrchStats.getHistory({
					offset: 0,
					limit: 10,
				});
				if (mountedRef.current) {
					setRecentCompletions(result.events);
				}
			} catch (err) {
				console.error('Failed to fetch recent completions:', err);
			} finally {
				if (mountedRef.current) {
					setRecentLoading(false);
				}
			}
		}

		fetchRecentCompletions();
	}, [data]); // Re-fetch when aggregation data changes (new events recorded)

	const activeWorkflowList = Array.from(activeWorkflows.values());

	if (loading) {
		return <TeamOrchSkeleton theme={theme} />;
	}

	return (
		<div className="space-y-6">
			{/* Summary Cards */}
			<TeamOrchSummaryCards
				theme={theme}
				data={data}
				activeWorkflowCount={activeWorkflowList.length}
			/>

			{/* Active Workflows */}
			<section>
				<h3 className="text-sm font-semibold mb-3" style={{ color: theme.colors.textMain }}>
					Active Workflows
				</h3>
				{activeWorkflowList.length === 0 ? (
					<p className="text-sm py-4" style={{ color: theme.colors.textDim }}>
						No active workflows
					</p>
				) : (
					<div className="space-y-3" role="list" aria-label="Active workflows">
						{activeWorkflowList.map((wf) => (
							<ActiveWorkflowCard key={wf.groupChatId} workflow={wf} theme={theme} />
						))}
					</div>
				)}
			</section>

			{/* Recent Completions */}
			<section>
				<h3 className="text-sm font-semibold mb-3" style={{ color: theme.colors.textMain }}>
					Recent Completions
				</h3>
				{recentLoading ? (
					<div className="space-y-2" aria-live="polite" aria-busy="true">
						{Array.from({ length: 3 }).map((_, i) => (
							<div
								key={i}
								className="h-12 rounded-lg"
								style={{
									backgroundColor: theme.colors.border,
									opacity: 0.15,
									animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
									animationDelay: `${i * 100}ms`,
								}}
							/>
						))}
					</div>
				) : recentCompletions.length === 0 ? (
					<TeamOrchEmptyState theme={theme} message="No completed workflows yet" />
				) : (
					<div className="space-y-2" role="list" aria-label="Recent completions">
						{recentCompletions.map((event) => (
							<CompletionRow key={event.id} event={event} theme={theme} />
						))}
					</div>
				)}
			</section>
		</div>
	);
});

/**
 * Card showing a single active workflow with real-time progress.
 */
const ActiveWorkflowCard = memo(function ActiveWorkflowCard({
	workflow,
	theme,
}: {
	workflow: ActiveWorkflowEntry;
	theme: Theme;
}) {
	const { state, topology } = workflow;
	const maxIter =
		state.stopAfterIteration !== undefined
			? state.iterationCount
			: topology.pattern === 'review-loop'
				? '?'
				: state.iterationCount;

	return (
		<div
			className="p-4 rounded-lg border flex items-start gap-4"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
			role="listitem"
			aria-label={`${workflow.chatName} - ${topologyDisplayName(topology.pattern)} - Iteration ${state.iterationCount}`}
		>
			{/* Pulsing status dot */}
			<div className="flex-shrink-0 mt-1">
				<div
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						backgroundColor: theme.colors.accent,
						animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
					}}
				/>
			</div>

			{/* Info */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 mb-1">
					<span className="text-sm font-semibold truncate" style={{ color: theme.colors.textMain }}>
						{workflow.chatName}
					</span>
					<TopologyBadge pattern={topology.pattern} theme={theme} />
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Iteration {state.iterationCount} of {maxIter}
				</div>
			</div>

			{/* Compact workflow graph preview */}
			<div className="flex-shrink-0">
				<WorkflowGraph
					topology={topology}
					executionState={state}
					participants={[]}
					theme={theme}
					compact={true}
				/>
			</div>
		</div>
	);
});

/**
 * A single row in the recent completions list.
 */
const CompletionRow = memo(function CompletionRow({
	event,
	theme,
}: {
	event: TeamOrchEvent;
	theme: Theme;
}) {
	const color = statusColor(event.status, theme);

	return (
		<div
			className="px-4 py-3 rounded-lg border flex items-center gap-3"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
			role="listitem"
			aria-label={`${event.groupChatName} - ${event.status} - ${formatDuration(event.duration)}`}
		>
			{/* Status dot */}
			<div
				className="flex-shrink-0"
				style={{
					width: 8,
					height: 8,
					borderRadius: '50%',
					backgroundColor: color,
				}}
			/>

			{/* Name */}
			<span
				className="text-sm font-medium truncate min-w-0 flex-1"
				style={{ color: theme.colors.textMain }}
			>
				{event.groupChatName}
			</span>

			{/* Topology badge */}
			<TopologyBadge pattern={event.topologyPattern} theme={theme} />

			{/* Iterations */}
			<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
				{event.iterationCount} iter
			</span>

			{/* Duration */}
			<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
				{formatDuration(event.duration)}
			</span>

			{/* Tokens */}
			<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
				{formatTokenCount(event.totalTokens)}
			</span>

			{/* Status badge */}
			<span
				className="text-xs px-2 py-0.5 rounded-full flex-shrink-0 font-medium"
				style={{
					backgroundColor: `${color}15`,
					color,
				}}
			>
				{event.status}
			</span>
		</div>
	);
});

/**
 * Small topology pattern badge.
 */
function TopologyBadge({ pattern, theme }: { pattern: string; theme: Theme }) {
	return (
		<span
			className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
			style={{
				backgroundColor: `${theme.colors.accent}15`,
				color: theme.colors.accent,
			}}
		>
			{topologyDisplayName(pattern)}
		</span>
	);
}

export default OverviewTab;
