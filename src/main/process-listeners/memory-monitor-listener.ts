/**
 * Memory Monitor Listener — tracks per-session state and triggers
 * mid-session memory injection when conditions warrant.
 *
 * Trigger conditions:
 * 1. Repeated errors (same error type 2+ times) → search memories with error message
 * 2. New tool domain detected → search memories for that tool/technology
 * 3. Periodic refresh (every 5th user write, >60s since last search) → search for new experiences
 * 4. Domain shift signal ([domain-shift: X] in agent output) → search memories for domain X
 * 5. High context usage (>70%) → reduce injection budget; >90% → stop injection
 *
 * Rate limiting:
 * - Max 1 search per liveSearchCooldownSeconds (default 60) per session
 * - Injection count/token caps enforced by LiveContextQueue (EXP-LIVE-01)
 *
 * Exclusions:
 * - Group chat sessions (prefix 'group-chat-')
 * - Batch sessions (regex match)
 * - Synopsis sessions (regex match)
 * - Sessions without projectPath
 * - SSH remote sessions (handled by LiveContextQueue drain)
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessListenerDependencies } from './types';
import { GROUP_CHAT_PREFIX } from './types';
import type { UsageStats, ToolExecution } from '../process-manager/types';
import type { AgentError, HistoryEntry } from '../../shared/types';

export interface SessionMonitorState {
	sessionId: string;
	agentType: string;
	projectPath: string;
	/** Context usage percentage 0-100, updated on each usage event */
	lastContextUsage: number;
	/** Context window size for budget calculations */
	lastContextWindow: number;
	/** Error type counts for repeated-error detection */
	errorCounts: Map<string, number>;
	/** Timestamp of last error (for cooldown) */
	lastErrorAt: number;
	/** Unique tool names used in this session (for new-domain detection) */
	toolDomains: Set<string>;
	/** Timestamp of last memory search (for cooldown enforcement) */
	lastSearchAt: number;
	/** Effective token budget (reduced when context >70%) */
	effectiveBudget: number;
	/** Current turn index (incremented on each turn-complete for this session) */
	turnIndex: number;
	/** Timestamp when the current turn started (set on turn-start) */
	currentTurnStartedAt: number;
	/** Tool executions accumulated during the current turn */
	currentTurnToolExecutions: ToolExecution[];
	/** Error events accumulated during the current turn */
	currentTurnErrors: AgentError[];
	/** Usage stats from the most recent usage event in this turn */
	currentTurnUsage: UsageStats | null;
	/** Annotation count snapshot at turn start (for computing VIBES delta) */
	annotationCountAtTurnStart: number;
	/** Manifest entry count snapshot at turn start */
	manifestCountAtTurnStart: number;
	/** Number of per-turn extractions triggered in this session */
	perTurnExtractionCount: number;
	/** Timestamp of last per-turn extraction (for cooldown) */
	lastPerTurnExtractionAt: number;
}

/** Memory store shape used by this listener */
export interface MemoryStoreAccessor {
	getConfig: () => Promise<Record<string, unknown>>;
	cascadingSearch: (
		query: string,
		config: unknown,
		agentType: string,
		projectPath?: string
	) => Promise<
		Array<{
			entry: { id: string; type?: string; content: string };
			similarity: number;
			combinedScore: number;
		}>
	>;
}

/** Live context queue shape used by this listener */
export interface LiveQueueAccessor {
	enqueue: (
		sessionId: string,
		content: string,
		source: string,
		tokenEstimate: number,
		memoryIds: string[]
	) => void;
	getWriteCount: (sessionId: string) => number;
}

/** Injectable memory module accessors — resolved lazily in production, injected in tests */
export interface MemoryModuleAccessors {
	getMemoryStore: () => MemoryStoreAccessor;
	getLiveContextQueue: () => LiveQueueAccessor;
}

// ─── Per-Turn Interestingness Scoring ──────────────────────────────────────

export interface TurnSignals {
	turnDurationMs: number;
	errors: AgentError[];
	toolExecutions: ToolExecution[];
	usage: UsageStats | null;
	vibesAnnotationsDelta: number;
	vibesManifestDelta: number;
	turnIndex: number;
	entrySuccess: boolean | undefined;
}

export function scoreTurnInterestingness(signals: TurnSignals): number {
	let score = 0;

	// Turn duration (longer turns = more likely substantive work)
	if (signals.turnDurationMs > 30_000) score += 0.1;
	if (signals.turnDurationMs > 120_000) score += 0.15;

	// Errors (especially error→fix pattern)
	if (signals.errors.length > 0) score += 0.3;
	if (signals.errors.length > 0 && signals.entrySuccess === true) score += 0.2;

	// Tool execution volume
	if (signals.toolExecutions.length > 3) score += 0.1;
	if (signals.toolExecutions.length > 8) score += 0.15;

	// VIBES richness
	if (signals.vibesAnnotationsDelta > 5) score += 0.15;
	if (signals.vibesManifestDelta > 0) score += 0.1;

	// Output token volume
	if (signals.usage) {
		const outputTokens = signals.usage.outputTokens ?? 0;
		if (outputTokens > 2000) score += 0.1;
		if (outputTokens > 5000) score += 0.1;
	}

	// Failed turns teach
	if (signals.entrySuccess === false) score += 0.15;

	// Early turns (setup/context) get penalty
	if (signals.turnIndex <= 2) score *= 0.5;

	return Math.min(score, 1.0);
}

// ─── VIBES Delta Tracking ──────────────────────────────────────────────────

async function snapshotVibesCounts(state: SessionMonitorState): Promise<void> {
	try {
		const fs = await import('fs/promises');
		const path = await import('path');

		// Count annotation lines
		try {
			const annotPath = path.join(state.projectPath, '.ai-audit', 'annotations.jsonl');
			const content = await fs.readFile(annotPath, 'utf-8');
			state.annotationCountAtTurnStart = content
				.trim()
				.split('\n')
				.filter((l) => l.length > 0).length;
		} catch {
			state.annotationCountAtTurnStart = 0;
		}

		// Count manifest entries
		try {
			const manifestPath = path.join(state.projectPath, '.ai-audit', 'manifest.json');
			const content = await fs.readFile(manifestPath, 'utf-8');
			const manifest = JSON.parse(content);
			const entries = manifest.entries;
			state.manifestCountAtTurnStart = Array.isArray(entries)
				? entries.length
				: entries && typeof entries === 'object'
					? Object.keys(entries).length
					: 0;
		} catch {
			state.manifestCountAtTurnStart = 0;
		}
	} catch {
		// VIBES not available — leave snapshots at 0
	}
}

async function computeVibesDeltas(
	state: SessionMonitorState
): Promise<{ annotationsDelta: number; manifestDelta: number }> {
	let currentAnnotations = 0;
	let currentManifest = 0;

	try {
		const fs = await import('fs/promises');
		const path = await import('path');

		try {
			const annotPath = path.join(state.projectPath, '.ai-audit', 'annotations.jsonl');
			const content = await fs.readFile(annotPath, 'utf-8');
			currentAnnotations = content
				.trim()
				.split('\n')
				.filter((l) => l.length > 0).length;
		} catch {
			/* no file */
		}

		try {
			const manifestPath = path.join(state.projectPath, '.ai-audit', 'manifest.json');
			const content = await fs.readFile(manifestPath, 'utf-8');
			const manifest = JSON.parse(content);
			const entries = manifest.entries;
			currentManifest = Array.isArray(entries)
				? entries.length
				: entries && typeof entries === 'object'
					? Object.keys(entries).length
					: 0;
		} catch {
			/* no file */
		}
	} catch {
		/* fs import failed */
	}

	return {
		annotationsDelta: Math.max(0, currentAnnotations - state.annotationCountAtTurnStart),
		manifestDelta: Math.max(0, currentManifest - state.manifestCountAtTurnStart),
	};
}

// ─── Memory Monitor Constants ──────────────────────────────────────────────

/** Common agent tools that don't indicate a novel domain */
const COMMON_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task']);

/** Domain-shift pattern from EXP-LIVE-03 directives */
const DOMAIN_SHIFT_REGEX = /\[domain-shift:\s*(.+?)\]/;

/** Default accessors that lazy-import memory modules at runtime */
async function defaultGetMemoryAccessors(): Promise<MemoryModuleAccessors | null> {
	try {
		const { getMemoryStore } = await import('../memory/memory-store');
		const { getLiveContextQueue } = await import('../memory/live-context-queue');
		return {
			getMemoryStore: getMemoryStore as unknown as () => MemoryStoreAccessor,
			getLiveContextQueue: getLiveContextQueue as unknown as () => LiveQueueAccessor,
		};
	} catch {
		return null;
	}
}

export function setupMemoryMonitorListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'logger' | 'patterns'>,
	memoryAccessors?: MemoryModuleAccessors
): void {
	const sessionStates = new Map<string, SessionMonitorState>();
	const { logger, patterns } = deps;
	const { REGEX_BATCH_SESSION, REGEX_SYNOPSIS_SESSION } = patterns;

	function shouldMonitor(sessionId: string): boolean {
		if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return false;
		if (REGEX_BATCH_SESSION.test(sessionId)) return false;
		if (REGEX_SYNOPSIS_SESSION.test(sessionId)) return false;
		return true;
	}

	function getState(sessionId: string): SessionMonitorState | null {
		if (!shouldMonitor(sessionId)) return null;
		let state = sessionStates.get(sessionId);
		if (!state) {
			const proc = processManager.get(sessionId);
			if (!proc?.projectPath) return null;
			state = {
				sessionId,
				agentType: proc.toolType || 'unknown',
				projectPath: proc.projectPath,
				lastContextUsage: 0,
				lastContextWindow: 200000,
				errorCounts: new Map(),
				lastErrorAt: 0,
				toolDomains: new Set(),
				lastSearchAt: 0,
				effectiveBudget: 750,
				turnIndex: 0,
				currentTurnStartedAt: 0,
				currentTurnToolExecutions: [],
				currentTurnErrors: [],
				currentTurnUsage: null,
				annotationCountAtTurnStart: 0,
				manifestCountAtTurnStart: 0,
				perTurnExtractionCount: 0,
				lastPerTurnExtractionAt: 0,
			};
			sessionStates.set(sessionId, state);
		}
		return state;
	}

	async function triggerMemorySearch(
		state: SessionMonitorState,
		query: string,
		source: 'monitoring'
	): Promise<void> {
		const now = Date.now();

		try {
			const accessors = memoryAccessors ?? (await defaultGetMemoryAccessors());
			if (!accessors) return;

			const store = accessors.getMemoryStore();
			const config = await store.getConfig();

			if (!config.enableLiveInjection) return;

			const cooldownSeconds = (config.liveSearchCooldownSeconds as number | undefined) ?? 60;
			const cooldownMs = cooldownSeconds * 1000;
			if (now - state.lastSearchAt < cooldownMs) return;

			state.lastSearchAt = now;

			const results = await store.cascadingSearch(
				query,
				config,
				state.agentType,
				state.projectPath
			);
			if (!results || results.length === 0) return;

			// Enqueue into LiveContextQueue if available (EXP-LIVE-01)
			try {
				const queue = accessors.getLiveContextQueue();

				const topResults = results.slice(0, 5);
				const lines = topResults.map(
					(r) => `- (${r.entry.type ?? 'experience'}) ${r.entry.content}`
				);
				const content = lines.join('\n');
				const tokenEstimate = Math.ceil(content.length / 4);
				const memoryIds = topResults.map((r) => r.entry.id).filter(Boolean);

				queue.enqueue(state.sessionId, content, source, tokenEstimate, memoryIds);
			} catch {
				// LiveContextQueue not available yet (EXP-LIVE-01) — skip enqueue
			}

			logger.debug('[MemoryMonitor] Triggered memory search', 'MemoryMonitor', {
				sessionId: state.sessionId,
				query: query.slice(0, 100),
				resultCount: Math.min(results.length, 5),
				source,
			});
		} catch (err) {
			logger.debug('[MemoryMonitor] Search failed (non-critical)', 'MemoryMonitor', {
				error: String(err),
			});
		}
	}

	// ── Event handlers ──

	// 1. Usage event: track context utilization, adjust budget
	processManager.on('usage', (sessionId: string, usageStats: UsageStats) => {
		const state = getState(sessionId);
		if (!state) return;

		const totalTokens = usageStats.inputTokens + usageStats.outputTokens;
		const window = usageStats.contextWindow > 0 ? usageStats.contextWindow : 200000;
		if (totalTokens > window) return; // Accumulated multi-tool — skip

		state.lastContextUsage = Math.round((totalTokens / window) * 100);
		state.lastContextWindow = window;

		if (state.lastContextUsage > 90) {
			state.effectiveBudget = 0;
		} else if (state.lastContextUsage > 70) {
			state.effectiveBudget = 300;
		} else {
			state.effectiveBudget = 750;
		}

		// Per-turn accumulator: store latest usage stats
		state.currentTurnUsage = usageStats;
	});

	// 2. Error event: track error counts, trigger on repeated errors
	processManager.on('agent-error', (sessionId: string, error: AgentError) => {
		const state = getState(sessionId);
		if (!state) return;
		if (state.effectiveBudget === 0) return;

		const errorType = error.type || 'unknown';
		const count = (state.errorCounts.get(errorType) || 0) + 1;
		state.errorCounts.set(errorType, count);
		state.lastErrorAt = Date.now();

		// Per-turn accumulator: track errors for interestingness scoring
		state.currentTurnErrors.push(error);

		if (count === 2) {
			const query = error.message || errorType;
			triggerMemorySearch(state, query, 'monitoring').catch(() => {});
		}
	});

	// 3. Tool execution event: track tool domains, trigger on new domain
	processManager.on('tool-execution', (sessionId: string, toolExec: ToolExecution) => {
		const state = getState(sessionId);
		if (!state) return;

		// Per-turn accumulator: track tool executions for interestingness scoring
		state.currentTurnToolExecutions.push(toolExec);

		if (state.effectiveBudget === 0) return;

		const toolName = toolExec.toolName;
		if (!toolName) return;

		if (!state.toolDomains.has(toolName)) {
			state.toolDomains.add(toolName);

			if (!COMMON_TOOLS.has(toolName)) {
				triggerMemorySearch(state, toolName, 'monitoring').catch(() => {});
			}
		}
	});

	// 4. Data event: detect domain-shift signals in agent output
	processManager.on('data', (sessionId: string, data: string) => {
		const state = getState(sessionId);
		if (!state) return;
		if (state.effectiveBudget === 0) return;

		const domainShiftMatch = data.match(DOMAIN_SHIFT_REGEX);
		if (domainShiftMatch) {
			const domain = domainShiftMatch[1];
			logger.debug('[MemoryMonitor] Domain shift detected', 'MemoryMonitor', {
				sessionId,
				domain,
			});
			triggerMemorySearch(state, domain, 'monitoring').catch(() => {});
		}
	});

	// 5. Per-turn tracking: subscribe to turn-start and turn-complete events
	import('../memory/turn-tracker')
		.then(({ getTurnTracker }) => {
			const turnTracker = getTurnTracker();

			// On turn-start: reset accumulators, snapshot VIBES counts
			turnTracker.on('turn-start', ({ sessionId }: { sessionId: string }) => {
				const state = sessionStates.get(sessionId);
				if (!state) return;

				state.currentTurnStartedAt = Date.now();
				state.currentTurnToolExecutions = [];
				state.currentTurnErrors = [];
				state.currentTurnUsage = null;

				// Snapshot VIBES file sizes for delta tracking
				snapshotVibesCounts(state).catch(() => {});
			});

			// On turn-complete: compute signals, score interestingness, maybe enqueue extraction
			turnTracker.on(
				'turn-complete',
				async ({
					sessionId,
					entry,
					turnIndex,
				}: {
					sessionId: string;
					entry: HistoryEntry;
					turnIndex: number;
				}) => {
					const state = sessionStates.get(sessionId);
					if (!state) return;

					state.turnIndex = turnIndex;

					// Skip excluded session types (same exclusions as existing monitor)
					if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return;
					if (/batch-\d+$/.test(sessionId)) return;
					if (/synopsis-\d+$/.test(sessionId)) return;

					// Check config
					try {
						let accessors_ = memoryAccessors;
						if (!accessors_) {
							const resolved = await defaultGetMemoryAccessors();
							if (!resolved) return;
							accessors_ = resolved;
						}

						const store = accessors_.getMemoryStore();
						const config = await store.getConfig();
						if (
							!config.enabled ||
							!config.enableExperienceExtraction ||
							!config.enablePerTurnExtraction
						) {
							logger.debug(
								'[MemoryMonitor] Per-turn extraction disabled by config',
								'MemoryMonitor',
								{
									enabled: config.enabled,
									experienceExtraction: config.enableExperienceExtraction,
									perTurnExtraction: config.enablePerTurnExtraction,
								}
							);
							return;
						}

						// Check per-session extraction cap
						const maxExtractions =
							(config.perTurnMaxExtractionsPerSession as number | undefined) ?? 10;
						if (state.perTurnExtractionCount >= maxExtractions) {
							logger.debug('[MemoryMonitor] Per-turn extraction cap reached', 'MemoryMonitor', {
								sessionId: state.sessionId,
								count: state.perTurnExtractionCount,
								max: maxExtractions,
							});
							return;
						}

						// Check per-session cooldown
						const cooldownMs = ((config.perTurnCooldownSeconds as number | undefined) ?? 60) * 1000;
						if (Date.now() - state.lastPerTurnExtractionAt < cooldownMs) {
							logger.debug('[MemoryMonitor] Per-turn extraction in cooldown', 'MemoryMonitor', {
								sessionId: state.sessionId,
								remaining: cooldownMs - (Date.now() - state.lastPerTurnExtractionAt),
							});
							return;
						}

						// Check high context usage (same guard as existing monitor)
						if (state.lastContextUsage > 90) return;

						// Compute VIBES deltas
						const vibesDeltas = await computeVibesDeltas(state);

						// Build turn signals and score
						const turnDurationMs =
							state.currentTurnStartedAt > 0
								? Date.now() - state.currentTurnStartedAt
								: (entry.elapsedTimeMs ?? 0);

						const signals = {
							turnDurationMs,
							errors: state.currentTurnErrors,
							toolExecutions: state.currentTurnToolExecutions,
							usage: state.currentTurnUsage,
							vibesAnnotationsDelta: vibesDeltas.annotationsDelta,
							vibesManifestDelta: vibesDeltas.manifestDelta,
							turnIndex,
							entrySuccess: entry.success,
						};

						const score = scoreTurnInterestingness(signals);
						const threshold =
							(config.perTurnInterestingnessThreshold as number | undefined) ?? 0.25;

						logger.debug('[MemoryMonitor] Turn interestingness scored', 'MemoryMonitor', {
							sessionId: state.sessionId,
							turnIndex,
							score: score.toFixed(2),
							threshold: threshold.toFixed(2),
							passed: score >= threshold,
						});

						if (score < threshold) return;

						// Enqueue per-turn extraction
						const { getMemoryJobQueue } = await import('../memory/memory-job-queue');
						getMemoryJobQueue().enqueue({
							type: 'experience-extraction',
							priority: 4,
							payload: {
								sessionId: state.sessionId,
								projectPath: state.projectPath,
								agentType: state.agentType,
								trigger: 'per-turn',
								turnIndex,
								interestScore: score,
								historyEntry: {
									summary: entry.summary,
									fullResponse: entry.fullResponse?.slice(0, 1500),
									success: entry.success,
									elapsedTimeMs: entry.elapsedTimeMs,
								},
								vibesAnnotationsDelta: vibesDeltas.annotationsDelta,
								vibesManifestDelta: vibesDeltas.manifestDelta,
							},
						});

						// Update per-turn tracking state
						state.perTurnExtractionCount++;
						state.lastPerTurnExtractionAt = Date.now();

						logger.debug('[MemoryMonitor] Per-turn extraction enqueued', 'MemoryMonitor', {
							sessionId: state.sessionId,
							turnIndex,
							score: score.toFixed(2),
						});
					} catch {
						// Non-critical — extraction will happen on exit
					}
				}
			);
		})
		.catch(() => {
			// TurnTracker not available — per-turn extraction won't work
		});

	// 6. Periodic trigger: check via interval for write-count based refreshes
	// Also triggers mid-session experience extraction at every 10th write
	const midSessionCheckpoints = new Set<string>(); // tracks "sessionId:checkpoint" keys
	const periodicInterval = setInterval(async () => {
		for (const [, state] of sessionStates) {
			if (state.effectiveBudget === 0) continue;

			try {
				let accessors_ = memoryAccessors;
				if (!accessors_) {
					const resolved = await defaultGetMemoryAccessors();
					if (!resolved) continue;
					accessors_ = resolved;
				}

				const queue = accessors_.getLiveContextQueue();
				const writeCount = queue.getWriteCount(state.sessionId);

				// Memory search refresh at every 5th write
				if (writeCount > 0 && writeCount % 5 === 0) {
					const now = Date.now();
					if (now - state.lastSearchAt >= 60000) {
						triggerMemorySearch(
							state,
							`recent experiences for ${state.projectPath}`,
							'monitoring'
						).catch(() => {});
					}
				}

				// Mid-session experience extraction at every 10th write
				if (writeCount >= 10 && writeCount % 10 === 0) {
					const checkpoint = `${state.sessionId}:mid:${Math.floor(writeCount / 10)}`;
					if (!midSessionCheckpoints.has(checkpoint)) {
						midSessionCheckpoints.add(checkpoint);
						// Fire-and-forget: check config + enqueue extraction job
						(async () => {
							try {
								const store = accessors_.getMemoryStore();
								const config = await store.getConfig();
								if (!config.enabled || !config.enableExperienceExtraction) return;
								// Skip mid-session extraction when per-turn extraction handles it
								if (config.enablePerTurnExtraction) return;

								const { getMemoryJobQueue } = await import('../memory/memory-job-queue');
								getMemoryJobQueue().enqueue({
									type: 'experience-extraction',
									priority: 4, // Between exit (3) and retroactive (5)
									payload: {
										sessionId: state.sessionId,
										projectPath: state.projectPath,
										agentType: state.agentType,
										trigger: 'mid-session',
									},
								});
								logger.debug('[MemoryMonitor] Mid-session extraction enqueued', 'MemoryMonitor', {
									sessionId: state.sessionId,
									writeCount,
									checkpoint,
								});
							} catch {
								// Non-critical — extraction will happen on exit
							}
						})();
					}
				}
			} catch {
				// Module not loaded yet — skip
			}
		}
	}, 10000);

	// Keep interval from preventing process exit
	if (periodicInterval.unref) {
		periodicInterval.unref();
	}

	// Cleanup: remove session state and checkpoint tracking on exit
	processManager.on('exit', (sessionId: string) => {
		sessionStates.delete(sessionId);
		// Clean up mid-session checkpoint entries for this session
		for (const key of midSessionCheckpoints) {
			if (key.startsWith(`${sessionId}:`)) {
				midSessionCheckpoints.delete(key);
			}
		}
	});
}
