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

// ─── Deduplication key fields per job type ───────────────────────────────────

const DEDUP_KEY_FIELDS: Record<MemoryJobType, string[]> = {
	'experience-extraction': ['sessionId'],
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
	getStatus(): { queueLength: number; currentJob: MemoryJobType | null; processing: boolean } {
		return {
			queueLength: this.queue.length,
			currentJob: this.currentJob?.type ?? null,
			processing: this.processing,
		};
	}

	/** Emit queue status to all renderer windows. */
	private emitStatus(): void {
		const status = this.getStatus();
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send('memory:job-queue-status', status);
		}
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
			} catch {
				// Job failed — log, don't retry (will re-trigger naturally)
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
					await getExperienceAnalyzer().analyzeCompletedSession(
						job.payload.sessionId as string,
						job.payload.projectPath as string,
						job.payload.agentType as string
					);
				} finally {
					this.llmInFlight = false;
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
