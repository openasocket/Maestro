/**
 * MemoryJobQueue — prioritized background processing for memory system operations.
 *
 * Processes jobs during idle time, respects rate limits, batches where possible,
 * and provides progress visibility to the UI via IPC events.
 *
 * Design constraints:
 * - NEVER blocks agent spawn or session exit
 * - At most 1 LLM call in flight at a time (prevents token storm)
 * - Jobs are lossy — if the app quits, pending jobs are dropped (they'll re-trigger)
 * - UI can observe queue state but cannot block on it
 */

import { BrowserWindow } from 'electron';
import type {
	JobQueueStatus,
	TokenUsage,
	ExtractionDiagnostic,
	ExtractionProgress,
} from '../../shared/memory-types';

// Re-export shared types for consumers that import from this module
export type { JobQueueStatus, TokenUsage, ExtractionProgress } from '../../shared/memory-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryJobType =
	| 'experience-extraction' // LLM call — expensive, max 1 concurrent
	| 'effectiveness-update' // File I/O — fast, batch-friendly
	| 'consolidation' // Embedding + file I/O — medium
	| 'confidence-decay' // File I/O — fast, run daily
	| 'hierarchy-suggestion' // File scan — medium, run on project open
	| 'digest-update' // File I/O — fast
	| 'embedding-backfill'; // Embedding service — batch-friendly

export interface MemoryJob {
	id: string;
	type: MemoryJobType;
	priority: number; // Lower = higher priority
	payload: Record<string, unknown>;
	createdAt: number;
	/** If set, don't process before this timestamp */
	deferUntil?: number;
}

// ─── Estimated processing time per job type (seconds) ────────────────────────

const JOB_TIME_ESTIMATES: Record<MemoryJobType, number> = {
	'experience-extraction': 60,
	'effectiveness-update': 1,
	consolidation: 3,
	'confidence-decay': 2,
	'hierarchy-suggestion': 3,
	'digest-update': 1,
	'embedding-backfill': 5,
};

// ─── Human-readable activity descriptions ────────────────────────────────────

function describeJob(job: MemoryJob): string {
	switch (job.type) {
		case 'experience-extraction': {
			const sid = job.payload.sessionId as string | undefined;
			return `Extracting experiences from session ${sid ? sid.slice(0, 8) + '...' : '(unknown)'}`;
		}
		case 'effectiveness-update':
			return 'Updating effectiveness scores';
		case 'consolidation':
			return 'Consolidating similar memories';
		case 'confidence-decay':
			return 'Applying confidence decay';
		case 'hierarchy-suggestion':
			return 'Generating hierarchy suggestions';
		case 'digest-update':
			return 'Updating project digest';
		case 'embedding-backfill':
			return 'Backfilling embeddings';
	}
}

// ─── Token cost estimates ────────────────────────────────────────────────────

/** Input token rate $/MTok */
const INPUT_RATE_PER_MTOK = 3;
/** Output token rate $/MTok */
const OUTPUT_RATE_PER_MTOK = 15;
/** Estimated tokens per extraction (8K input + 2K output) */
const EXTRACTION_INPUT_TOKENS = 8000;
const EXTRACTION_OUTPUT_TOKENS = 2000;
const EXTRACTION_TOTAL_TOKENS = EXTRACTION_INPUT_TOKENS + EXTRACTION_OUTPUT_TOKENS;
const EXTRACTION_COST_USD =
	(EXTRACTION_INPUT_TOKENS / 1_000_000) * INPUT_RATE_PER_MTOK +
	(EXTRACTION_OUTPUT_TOKENS / 1_000_000) * OUTPUT_RATE_PER_MTOK;
/** Estimated tokens per per-turn extraction (3K input + 1K output) */
const TURN_EXTRACTION_INPUT_TOKENS = 3000;
const TURN_EXTRACTION_OUTPUT_TOKENS = 1000;
const TURN_EXTRACTION_TOTAL_TOKENS = TURN_EXTRACTION_INPUT_TOKENS + TURN_EXTRACTION_OUTPUT_TOKENS;
const TURN_EXTRACTION_COST_USD =
	(TURN_EXTRACTION_INPUT_TOKENS / 1_000_000) * INPUT_RATE_PER_MTOK +
	(TURN_EXTRACTION_OUTPUT_TOKENS / 1_000_000) * OUTPUT_RATE_PER_MTOK;

// ─── Deduplication key fields per job type ───────────────────────────────────

const DEDUP_KEY_FIELDS: Record<MemoryJobType, string[]> = {
	'experience-extraction': ['sessionId', 'turnIndex'],
	'effectiveness-update': ['sessionId'],
	consolidation: ['projectPath', 'skillAreaId'],
	'confidence-decay': [],
	'hierarchy-suggestion': ['projectPath'],
	'digest-update': ['projectPath'],
	'embedding-backfill': ['projectPath'],
};

// ─── MemoryJobQueue ─────────────────────────────────────────────────────────

export class MemoryJobQueue {
	private queue: MemoryJob[] = [];
	private processing = false;
	private currentJob: MemoryJob | null = null;
	private running = false;
	private llmInFlight = false;
	private idCounter = 0;
	private tokenUsage: TokenUsage = {
		extractionTokens: 0,
		injectionTokens: 0,
		estimatedCostUsd: 0,
		extractionCalls: 0,
		trackingSince: Date.now(),
	};
	private emitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	/** Ring buffer of recent extraction diagnostics (max 20, getStatus returns last 5) */
	private diagnostics: ExtractionDiagnostic[] = [];
	/** Real-time progress of the current extraction (null when idle) */
	private currentProgress: ExtractionProgress | null = null;

	/** Enqueue a job. Deduplicates by type + key fields. */
	enqueue(job: Omit<MemoryJob, 'id' | 'createdAt'>): string {
		// Deduplication check
		const keyFields = DEDUP_KEY_FIELDS[job.type] || [];
		const isDuplicate = this.queue.some((existing) => {
			if (existing.type !== job.type) return false;
			return keyFields.every((field) => existing.payload[field] === job.payload[field]);
		});

		if (isDuplicate) {
			return ''; // Already queued
		}

		const id = `mem-job-${++this.idCounter}-${Date.now()}`;
		const fullJob: MemoryJob = {
			...job,
			id,
			createdAt: Date.now(),
		};

		// LLM concurrency guard: defer experience-extraction if LLM already in flight
		if (job.type === 'experience-extraction' && this.llmInFlight) {
			fullJob.deferUntil = Math.max(fullJob.deferUntil ?? 0, Date.now() + 30000);
		}

		this.queue.push(fullJob);
		this.emitStatusDebounced();
		return id;
	}

	/** Start the idle processing loop. */
	start(): void {
		this.running = true;

		// Schedule daily confidence decay (deferred to 1 hour after startup)
		this.enqueue({
			type: 'confidence-decay',
			priority: 7,
			payload: { halfLifeDays: 30 },
			deferUntil: Date.now() + 3600000, // 1 hour from now
		});

		this.runLoop();
	}

	/** Stop processing (app shutdown). */
	stop(): void {
		this.running = false;
	}

	/** Get current queue state for UI. */
	getStatus(): JobQueueStatus {
		const estimatedSecondsRemaining =
			this.processing || this.queue.length > 0 ? this.estimateRemainingSeconds() : null;

		return {
			queueLength: this.queue.length,
			currentJob: this.currentJob?.type ?? null,
			currentActivity: this.currentJob ? describeJob(this.currentJob) : null,
			processing: this.processing,
			estimatedSecondsRemaining,
			recentDiagnostics: this.diagnostics.slice(-5),
			extractionProgress: this.currentProgress,
		};
	}

	/** Get cumulative token usage (last 24h). */
	getTokenUsage(): TokenUsage {
		return { ...this.tokenUsage };
	}

	/** Track injection tokens reported by the memory injector. */
	trackInjectionTokens(tokenCount: number): void {
		this.tokenUsage.injectionTokens += tokenCount;
		// Injection cost: all injection tokens are input tokens (prompt prefix)
		this.tokenUsage.estimatedCostUsd += (tokenCount / 1_000_000) * INPUT_RATE_PER_MTOK;
	}

	/** Reset token tracking counters (called during daily confidence-decay). */
	private resetTokenTracking(): void {
		this.tokenUsage = {
			extractionTokens: 0,
			injectionTokens: 0,
			estimatedCostUsd: 0,
			extractionCalls: 0,
			trackingSince: Date.now(),
		};
	}

	/** Estimate remaining seconds for all queued + current jobs. */
	private estimateRemainingSeconds(): number {
		let seconds = 0;
		if (this.currentJob) {
			// Assume half the estimated time remains for the current job
			seconds += JOB_TIME_ESTIMATES[this.currentJob.type] / 2;
		}
		for (const job of this.queue) {
			seconds += JOB_TIME_ESTIMATES[job.type];
		}
		return Math.round(seconds);
	}

	/** Emit queue status to all renderer windows. */
	private emitStatus(): void {
		try {
			const status = this.getStatus();
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send('memory:jobQueueUpdate', status);
			}
		} catch {
			// Electron not available (testing) — skip
		}
	}

	/** Debounced emit — avoids spamming UI when multiple jobs enqueue rapidly. */
	private emitStatusDebounced(): void {
		if (this.emitDebounceTimer) return;
		this.emitDebounceTimer = setTimeout(() => {
			this.emitDebounceTimer = null;
			this.emitStatus();
		}, 200);
	}

	/** Sleep helper. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** Main processing loop. */
	private async runLoop(): Promise<void> {
		while (this.running) {
			if (this.queue.length === 0) {
				// Nothing to do — wait 5 seconds before checking again
				await this.sleep(5000);
				continue;
			}

			// Sort by priority, then by createdAt (FIFO within same priority)
			this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

			// Skip deferred jobs
			const now = Date.now();
			const next = this.queue.find((j) => !j.deferUntil || j.deferUntil <= now);
			if (!next) {
				await this.sleep(2000);
				continue;
			}

			// Process
			this.queue = this.queue.filter((j) => j.id !== next.id);
			this.currentJob = next;
			this.processing = true;
			this.emitStatus();

			try {
				await this.executeJob(next);
			} catch (err) {
				// Job failed — log for diagnostics, don't retry (will re-trigger naturally)
				console.error(
					`[MemoryJobQueue] Job ${next.type} (${next.id}) failed:`,
					err instanceof Error ? err.message : err
				);
			}

			this.currentJob = null;
			this.processing = false;
			this.emitStatus();

			// Brief pause between jobs to avoid CPU spike
			await this.sleep(500);
		}
	}

	/** Route job to the appropriate implementation. */
	private async executeJob(job: MemoryJob): Promise<void> {
		switch (job.type) {
			case 'effectiveness-update': {
				const { onProcessComplete } = await import('./memory-effectiveness');
				await onProcessComplete(
					job.payload.sessionId as string,
					job.payload.exitCode as number,
					job.payload.projectPath as string | undefined
				);
				break;
			}
			case 'experience-extraction': {
				this.llmInFlight = true;
				try {
					const { getExperienceAnalyzer } = await import('./experience-analyzer');
					const analyzer = getExperienceAnalyzer();

					// Progress callback: store progress and emit to UI
					const onProgress = (progress: ExtractionProgress) => {
						this.currentProgress = progress;
						this.emitStatus();
					};

					// Route per-turn extractions to analyzeTurn()
					if (job.payload.trigger === 'per-turn' && job.payload.turnIndex != null) {
						await analyzer.analyzeTurn(
							job.payload.sessionId as string,
							job.payload.projectPath as string,
							job.payload.agentType as string,
							job.payload.turnIndex as number,
							(job.payload.interestScore as number) ?? 0.5,
							job.payload.historyEntry as {
								summary: string;
								fullResponse?: string;
								success?: boolean;
								elapsedTimeMs?: number;
							},
							(job.payload.vibesAnnotationsDelta as number) ?? 0,
							(job.payload.vibesManifestDelta as number) ?? 0,
							onProgress
						);
					} else {
						// Existing path: full session analysis
						await analyzer.analyzeCompletedSession(
							job.payload.sessionId as string,
							job.payload.projectPath as string,
							job.payload.agentType as string,
							(job.payload.trigger as 'exit' | 'retroactive' | 'mid-session') ?? 'exit',
							onProgress
						);
					}

					// Clear progress after completion
					this.currentProgress = null;

					// Collect diagnostic from analyzer, annotate with job trigger for UI clarity
					if (analyzer.lastDiagnostic) {
						analyzer.lastDiagnostic.trigger =
							(job.payload.trigger as ExtractionDiagnostic['trigger']) ?? 'exit';
						this.diagnostics.push(analyzer.lastDiagnostic);
						// Keep ring buffer at max 20
						if (this.diagnostics.length > 20) {
							this.diagnostics = this.diagnostics.slice(-20);
						}
					}

					// Track token consumption — use real data if available, else fallback to estimates
					const realUsage = analyzer.lastDiagnostic?.tokenUsage;
					if (realUsage && (realUsage.inputTokens > 0 || realUsage.outputTokens > 0)) {
						const totalTokens = realUsage.inputTokens + realUsage.outputTokens;
						this.tokenUsage.extractionTokens += totalTokens;
						this.tokenUsage.extractionCalls++;
						this.tokenUsage.estimatedCostUsd +=
							(realUsage.inputTokens / 1_000_000) * INPUT_RATE_PER_MTOK +
							(realUsage.outputTokens / 1_000_000) * OUTPUT_RATE_PER_MTOK;
					} else if (analyzer.lastDiagnostic?.status === 'success') {
						// Use accurate estimates based on extraction type
						const isPerTurn = job.payload.trigger === 'per-turn';
						const estTokens = isPerTurn ? TURN_EXTRACTION_TOTAL_TOKENS : EXTRACTION_TOTAL_TOKENS;
						const estCost = isPerTurn ? TURN_EXTRACTION_COST_USD : EXTRACTION_COST_USD;
						this.tokenUsage.extractionTokens += estTokens;
						this.tokenUsage.extractionCalls++;
						this.tokenUsage.estimatedCostUsd += estCost;
					}
				} finally {
					this.llmInFlight = false;
					this.currentProgress = null;
				}
				break;
			}
			case 'consolidation': {
				const { getMemoryCollector } = await import('./memory-collector');
				const collector = getMemoryCollector();
				await collector.detectPatterns(
					job.payload.projectPath as string,
					job.payload.agentType as string
				);
				break;
			}
			case 'confidence-decay': {
				const { runGlobalConfidenceDecay } = await import('./memory-effectiveness');
				await runGlobalConfidenceDecay((job.payload.halfLifeDays as number) ?? 30);

				// Reset daily token tracking counters
				this.resetTokenTracking();

				// Re-enqueue for next day
				this.enqueue({
					type: 'confidence-decay',
					priority: 7,
					payload: { halfLifeDays: 30 },
					deferUntil: Date.now() + 86400000, // 24 hours
				});
				break;
			}
			case 'digest-update': {
				const { getMemoryStore } = await import('./memory-store');
				const store = getMemoryStore();
				await store.generateProjectDigest(job.payload.projectPath as string);
				break;
			}
			case 'hierarchy-suggestion': {
				// Placeholder — hierarchy suggestions not yet implemented
				break;
			}
			case 'embedding-backfill': {
				// Placeholder — embedding backfill not yet implemented
				break;
			}
		}
	}

	/**
	 * Enqueue retroactive analysis for all unanalyzed historical sessions.
	 * Returns stats about what was queued.
	 */
	async enqueueRetroactiveAnalysis(): Promise<{ total: number; queued: number; skipped: number }> {
		const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
		const registry = getAnalyzedSessionsRegistry();
		const unanalyzed = await registry.getUnanalyzedSessionIds();

		const { getHistoryManager } = await import('../history-manager');
		const hm = getHistoryManager();

		// Load sessions store for metadata
		const { getSessionsStore } = await import('../stores');
		const sessions = getSessionsStore().get('sessions', []) as {
			id: string;
			toolType?: string;
			projectRoot?: string;
			cwd?: string;
		}[];

		let queued = 0;
		let skipped = 0;

		for (const sessionId of unanalyzed) {
			const entries = hm.getEntries(sessionId);
			if (entries.length < 3) {
				skipped++;
				continue;
			}

			// Get projectPath from history entries
			const projectPath = entries[0]?.projectPath;
			if (!projectPath) {
				skipped++;
				continue;
			}

			// Look up agentType from sessions store
			const baseId = sessionId.replace(/-ai-.+$|-terminal$|-batch-\d+$|-synopsis-\d+$/, '');
			const session = sessions.find((s) => s.id === baseId);
			const agentType = session?.toolType ?? 'unknown';

			this.enqueue({
				type: 'experience-extraction',
				priority: 5, // Lower than exit-triggered (3)
				payload: { sessionId, projectPath, agentType, trigger: 'retroactive' },
			});
			queued++;
		}

		return { total: unanalyzed.length, queued, skipped };
	}

	/**
	 * Get analysis stats for the UI.
	 */
	async getAnalysisStats(): Promise<{
		totalSessions: number;
		analyzedSessions: number;
		unanalyzedSessions: number;
	}> {
		try {
			const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
			const registry = getAnalyzedSessionsRegistry();
			const analyzed = await registry.getAnalyzedCount();
			const unanalyzed = await registry.getUnanalyzedSessionIds();
			return {
				totalSessions: analyzed + unanalyzed.length,
				analyzedSessions: analyzed,
				unanalyzedSessions: unanalyzed.length,
			};
		} catch {
			return { totalSessions: 0, analyzedSessions: 0, unanalyzedSessions: 0 };
		}
	}

	/**
	 * Enqueue retroactive analysis for history sessions belonging to a specific Maestro agent.
	 * Matches history files whose session ID starts with the agent's base ID prefix.
	 */
	async enqueueAgentAnalysis(
		agentId: string,
		agentType: string,
		projectPath?: string
	): Promise<{ total: number; queued: number; skipped: number; alreadyAnalyzed: number }> {
		const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
		const registry = getAnalyzedSessionsRegistry();

		const { getHistoryManager } = await import('../history-manager');
		const hm = getHistoryManager();
		const allHistorySessions = hm.listSessionsWithHistory();

		// Filter to sessions belonging to this agent (history files are named like: {agentId}-ai-{ts})
		const agentSessions = allHistorySessions.filter((sid) => sid.startsWith(agentId));

		let queued = 0;
		let skipped = 0;
		let alreadyAnalyzed = 0;

		for (const sessionId of agentSessions) {
			if (await registry.isAnalyzed(sessionId)) {
				alreadyAnalyzed++;
				continue;
			}

			const entries = hm.getEntries(sessionId);
			if (entries.length < 3) {
				skipped++;
				continue;
			}

			const entryProjectPath = projectPath || entries[0]?.projectPath;
			if (!entryProjectPath) {
				skipped++;
				continue;
			}

			this.enqueue({
				type: 'experience-extraction',
				priority: 5,
				payload: { sessionId, projectPath: entryProjectPath, agentType, trigger: 'retroactive' },
			});
			queued++;
		}

		return { total: agentSessions.length, queued, skipped, alreadyAnalyzed };
	}

	/**
	 * Get analysis stats for a specific agent.
	 */
	async getAgentAnalysisStats(agentId: string): Promise<{
		totalSessions: number;
		analyzedSessions: number;
		unanalyzedSessions: number;
	}> {
		try {
			const { getAnalyzedSessionsRegistry } = await import('./analyzed-sessions');
			const registry = getAnalyzedSessionsRegistry();

			const { getHistoryManager } = await import('../history-manager');
			const hm = getHistoryManager();
			const allHistorySessions = hm.listSessionsWithHistory();
			const agentSessions = allHistorySessions.filter((sid) => sid.startsWith(agentId));

			let analyzed = 0;
			for (const sid of agentSessions) {
				if (await registry.isAnalyzed(sid)) analyzed++;
			}

			return {
				totalSessions: agentSessions.length,
				analyzedSessions: analyzed,
				unanalyzedSessions: agentSessions.length - analyzed,
			};
		} catch {
			return { totalSessions: 0, analyzedSessions: 0, unanalyzedSessions: 0 };
		}
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _queue: MemoryJobQueue | null = null;

export function getMemoryJobQueue(): MemoryJobQueue {
	if (!_queue) {
		_queue = new MemoryJobQueue();
		_queue.start();
	}
	return _queue;
}

export function shutdownMemoryJobQueue(): void {
	_queue?.stop();
	_queue = null;
}
